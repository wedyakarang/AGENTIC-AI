let sessions = {};


function createSession(id){

    sessions[id]={
        step:"IDLE",

        promotion:{}
    };

}


function getSession(id){

    if(!sessions[id]){
        createSession(id);
    }

    return sessions[id];

}


function deleteSession(id){

    delete sessions[id];

}


module.exports={
    getSession,
    deleteSession
};